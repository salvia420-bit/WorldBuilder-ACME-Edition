// vehicle-m2-observer.eval.js — non-capable observer page.
// phase "position": teleport ~30 m from the target (window.__vehiclePrev.target) and confirm it is in view.
// phase "verify": the target died in THIS (non-capable) session's world: its entity is gone or dead and a corpse
// named "Corpse of <name>" lies where it stood; and this session received no HBV1 message.
const R = window.__vehicleRun || {};
const prev = window.__vehiclePrev || {};
const t = prev.target;
const h = window.__sessionHandle, em = window.liveScene3d.entityManager;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!t) return { fatal: "no target from the setup step" };
let wire = null; try { wire = JSON.parse(h.vehicleWireStats()); } catch (_) { /* */ }
// M5: the retail chat line (server property vehicle_retail_chat) reaches this non-capable session as ordinary chat
if (!window.__vehChat) {
  window.__vehChat = [];
  window.__chatHooks?.onIncoming?.((e) => { if (e && typeof e.text === "string") window.__vehChat.push(e.text); });
}
const vehicleChat = () => window.__vehChat.filter((l) => /roars overhead|drops out of the sky/.test(l));
if ((R.phase || "position") === "position") {
  const gx = t.x + 30, gy = t.y;
  const lbx = Math.floor(gx / 192), lby = Math.floor(gy / 192), lx = gx - lbx * 192, ly = gy - lby * 192;
  const cell = ((lbx << 24) | (lby << 16) | (Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1)) >>> 0;
  h.sendChat(`@teleloc 0x${cell.toString(16)} ${lx.toFixed(2)} ${ly.toFixed(2)} ${(t.z + 0.5).toFixed(2)}`);
  let seen = null;
  for (let i = 0; i < 60 && !seen; i++) { await sleep(500); seen = em.entityMap.get(t.guid) ?? null; }
  return { carry: prev, summary: { targetInView: !!seen, name: seen?.meta?.name ?? null, hbv1Received: wire?.received_total ?? null, capable: typeof window.__vehicles === "object" } };
}
// verify
const corpse = [...em.entityMap.values()].find((i) => (i.meta?.name ?? "") === `Corpse of ${t.name}` &&
  Math.hypot(i.root.position.x - t.x, i.root.position.y - t.y) < 15);
const inst = em.entityMap.get(t.guid);
let deadHeld = null; try { deadHeld = em.isDeathHeld?.(t.guid) ?? null; } catch (_) { /* */ }
return { carry: prev, summary: { corpseNearTarget: !!corpse, targetEntityPresent: !!inst, targetDeathHeld: deadHeld, hbv1Received: wire?.received_total ?? null, capable: typeof window.__vehicles === "object", retailChat: vehicleChat() } };
