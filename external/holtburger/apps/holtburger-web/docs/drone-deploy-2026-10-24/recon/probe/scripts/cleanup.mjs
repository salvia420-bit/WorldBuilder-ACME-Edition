import { connect, sleep } from "./lib.mjs";
const { page } = await connect();
const r = await page.evaluate(() => {
  const out = {};
  const P = window.__droneProbe, em = window.liveScene3d?.entityManager;
  try { P?.clearProps(); out.props = "cleared"; } catch (e) { out.props = String(e); }
  try { for (const c of P?.hiddenKids || []) em.setFilmHidden(c, false); out.unhidden = (P?.hiddenKids || []).length; } catch (e) { out.unhidden = String(e); }
  try { if (P?.owner) { P.owner.release?.(); P.owner.dispose?.(); } out.owner = "disposed"; } catch (e) { out.owner = String(e); }
  try { P?.motion(0x41000003); } catch (_) {}
  try { window.__cam?.release?.(); out.cam = "released"; } catch (e) { out.cam = String(e); }
  try { if (window.__dpSend) { WebSocket.prototype.send = window.__dpSend.orig; delete window.__dpSend; out.send = "restored"; } } catch (e) { out.send = String(e); }
  try { delete window.__droneProbe; } catch (_) {}
  out.filmHooksLeft = !!window.liveScene3d?.film;
  return out;
});
console.log("page cleanup:", JSON.stringify(r));
await page.goto("about:blank");
console.log("navigated to about:blank");
process.exit(0);
