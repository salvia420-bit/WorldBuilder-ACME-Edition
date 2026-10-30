// rc-eye.mjs — RC-EYE stills (batch-RC-rust-scene-core, 2026-10-29) on an already-booted page:
// the same player teleport + the same debug camera per shot, so a defaults boot and an all-off boot
// (`hbsess.mjs boot --no-orbit --flags 'renderDiag=on&skytime=13[&<allOffFlags>]'`) compare frame
// for frame. Checklist (queue RC-EYE): Holtburg orbit + street (statics, buildings, animated
// scenery, terrain VFX), an interior, a road verge (scatter + grass), NPCs / the player (chase cam),
// Linvak Tukal (the ~14k scripted anchors' emitters, ?anchorOffGraph), and night (ramp + cloud
// shadows). Particle positions differ between the arms by design (?rustParticles' own RNG).
//   node scripts/perf-worker/rc-eye.mjs <outPrefix>
// Raw CDP only (lib/cdp_raw.mjs): Playwright's connectOverCDP hangs on the box's Chrome 156.
import { writeFileSync } from "node:fs";
import { rawSession } from "./lib/cdp_raw.mjs";

const out = process.argv[2];
if (!out) { console.error("usage: node rc-eye.mjs <outPrefix>"); process.exit(2); }
const CDP = "http://127.0.0.1:9333";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { pg, cdp } = await rawSession(CDP);

// Global AC metres (landblock origin folded in), as __cam uses.
const LB = (hex) => [((hex >> 8) & 0xff) * 192, (hex & 0xff) * 192];
const room = (name, lbHex, cell, cx, cy, gz) => {
  const [ox, oy] = LB(lbHex);
  return { name, tele: `@teleloc 0x${cell.toString(16)} ${(cx - ox).toFixed(1)} ${(cy - oy).toFixed(1)} ${(gz + 1).toFixed(1)}`,
    cam: [cx - 2.5, cy - 2.5, gz + 2.4, cx + 1.5, cy + 1.5, gz] };
};
const HOLT = "@teleloc 0xA9B40001 96 96 80 0 0 0 1";
const SHOTS = [
  { name: "holtburg-chase", tele: HOLT },
  { name: "holtburg-orbit", tele: HOLT, orbit: [32544, 34656, 81.5, 70, 45, 22] },
  { name: "holtburg-street", tele: HOLT, player: [9, 200, 10, 1.5] },
  { name: "holtburg-street-2", tele: HOLT, player: [9, 20, 10, 1.5] },
  room("holtburg-room-a9b40121", 0xa9b4, 0xa9b40121, 32552.5, 34695.7, 66),
  { name: "road-verge", tele: "@tele 42.0n 33.6e", cam: [32532, 34538, 105, 32532, 34556, 95] },
  { name: "linvak-tukal", tele: "@teleloc 0xA21E001A 83 38 560.4", orbitPlayer: [45, 30, 25] },
  { name: "linvak-tukal-close", tele: "@teleloc 0xA21E001A 83 38 560.4", player: [10, 120, 15, 1.5] },
  { name: "holtburg-night-orbit", tele: HOLT, orbit: [32544, 34656, 81.5, 70, 45, 22], hour: 22 },
  { name: "holtburg-night-chase", tele: HOLT, hour: 22 },
  // S1-EYE (round 3 lane Q2, 2026-10-30; queue batch-R3-S1-2026-10-30.json): appended, the shots above are
  // unchanged. Each one sets its sky hour (the night shots above leave the override at 22). Teleports are the
  // queue's grounded hopRoutes.west4 stops; the critter subjects are from the base-DAT bake (LB-local x, y), the
  // orbit targets 1.5 m (critters) / 6 m (seagulls) above the retail ground (28.0 / 32.0 m).
  { name: "west4-w1-hop", tele: "@teleloc 0xA8B40025 96 96 53.6", hour: 13 },
  { name: "critter-insect-cloud-a7b4", tele: "@teleloc 0xA7B4001D 90 96 31.8", hour: 13, orbit: [LB(0xa7b4)[0] + 139.3, LB(0xa7b4)[1] + 124.7, 29.5, 8, 200, 12] },
  { name: "critter-butterflies-a7b5", tele: "@teleloc 0xA7B4001D 90 96 31.8", hour: 13, orbit: [LB(0xa7b5)[0] + 78.9, LB(0xa7b5)[1] + 65.2, 29.5, 10, 236, 12] },
  { name: "critter-seagulls-a6b3", tele: "@teleloc 0xA6B40025 96 96 38.5", hour: 13, orbit: [LB(0xa6b3)[0] + 179.8, LB(0xa6b3)[1] + 108.1, 38.0, 25, 180, 12] },
  { name: "townnetwork-room", tele: "@telepoi TownNetwork", hour: 13 },
  { ...room("holtburg-room-a9b40121-night", 0xa9b4, 0xa9b40121, 32552.5, 34695.7, 66), hour: 22 },
];

const res = [];
for (const s of SHOTS) {
  await pg.evaluate(() => { try { window.__cam.release(); } catch (_) {} });
  await pg.evaluate((cmd) => window.__sessionHandle.sendChat(cmd), s.tele);
  await sleep(14000);
  // settle: the portal tunnel ends and the loaded set stops changing
  for (let i = 0; i < 20; i++) {
    const t = await pg.evaluate(() => (typeof window.__isPortalSpaceActive === "function" ? window.__isPortalSpaceActive() : false)).catch(() => false);
    if (!t) break;
    await sleep(1000);
  }
  let last = null, since = Date.now();
  for (const t0 = Date.now(); Date.now() - t0 < 60000;) {
    const cur = await pg.evaluate(() => `${window.__landblockLru?.entries?.size}|${window.liveScene3d?.renderer?.info?.memory?.geometries}`).catch(() => null);
    if (cur !== last) { last = cur; since = Date.now(); } else if (Date.now() - since >= 6000) break;
    await sleep(1000);
  }
  if (s.hour !== undefined) {
    await pg.evaluate((h) => window.__sessionHandle.setSkyTimeOverride(h / 24), s.hour);
    await sleep(8000);
  }
  if (s.cam) await pg.evaluate((v) => window.__cam.set(...v), s.cam);
  else if (s.orbit) await pg.evaluate((v) => window.__cam.orbit(...v), s.orbit);
  else if (s.player) await pg.evaluate((v) => window.__cam.player(...v), s.player);
  else if (s.orbitPlayer) await pg.evaluate((v) => { const p = window.__cam.world(); window.__cam.orbit(p.x, p.y, p.z + 1.5, ...v); }, s.orbitPlayer);
  await sleep(3000);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const png = `${out}-${s.name}.png`;
  writeFileSync(png, Buffer.from(shot.data, "base64"));
  const st = await pg.evaluate(() => {
    let pose = null;
    try { const p = window.__sessionHandle.getLocalPlayerPose(); pose = { lb: (p.landblockId >>> 0).toString(16), x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) }; try { p.free?.(); } catch (_) {} } catch (_) {}
    const call = (f) => { try { return typeof f === "function" ? f() : null; } catch (e) { return String(e); } };
    const pd = call(window.__particleInstancingDiag);
    const an = call(window.__rustAnimScenery?.stats);
    return { pose, emitters: pd && pd.emitters, rustEmitters: pd && pd.rustEmitters, live: pd && pd.liveParticles,
      animGroups: an && an.groups, sky: window.__skyTimePin ?? null };
  }).catch((e) => ({ error: String(e) }));
  res.push({ shot: s.name, png, ...st });
  console.log(s.name, JSON.stringify(st));
}
await pg.evaluate(() => { try { window.__cam.release(); } catch (_) {} });
const errs = await pg.evaluate(() => (window.__hbConsoleErrors || []).slice(0, 20)).catch(() => null);
writeFileSync(`${out}-eye.json`, JSON.stringify({ res, consoleErrors: errs }, null, 1));
console.log("console errors", Array.isArray(errs) ? errs.length : errs);
process.exit(0);
