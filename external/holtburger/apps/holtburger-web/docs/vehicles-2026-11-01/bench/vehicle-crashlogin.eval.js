// vehicle-crashlogin.eval.js — the H2 test, part 2 (pilot page, right after login following the crash): where did the
// character enter? On the ground (SanitizeLoginLocation snapped the sky save) or in the air?
const h = window.__sessionHandle, em = window.liveScene3d.entityManager;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3000);
let pose = null;
try { const p = h.getLocalPlayerPose(); pose = p ? { cell: (p.landblockId >>> 0).toString(16), x: p.x, y: p.y, z: p.z } : null; try { p?.free?.(); } catch (_) {} } catch (_) {}
const r = em.entityMap.get((window.getLocalPlayerGuid?.() ?? 0) >>> 0)?.root?.position;
const g = r ? (() => { try { return h.terrainHeightAt(r.x, r.y); } catch (_) { return null; } })() : null;
const aboveGround = r && Number.isFinite(g) ? Math.round((r.z - g) * 100) / 100 : null;
return { summary: { pose, rig: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.z * 10) / 10] : null, ground: g, aboveGround, onGround: aboveGround != null && Math.abs(aboveGround) < 3 } };
