// film-ground-probe.eval.js — take B's recording page, the ground observer (film-hellcat-1070.mjs, reshoot B2,
// 2026-11-02). Installs window.__groundProbe and returns at once; the driver calls its methods.
//
// WHY a sidestep: ACE applies vehicle_observer_sight_radius (and the 5x5 landblock first-sight search) only in the
// OBSERVER's own cell change (PhysicsObj.enter_cell_server -> handle_visible_cells -> AddVisibleObject). A MOVING
// object reaches a STANDING player only through its own cell change, handle_visible_cells_non_player ->
// ObjectMaint.GetVisibleObjectsDist: a fixed 112.5 m 2D clamp. So an observer standing still meets the Hellcat at
// ~112 m whatever its radius (take B: ~1 s before the pass), however it logged in. One sidestep across a 24 m cell
// line while the Hellcat is inside the radius makes the server run the observer's wide first sight once; the client
// reports a cell change at once (holtburger-core movement: the retail ShouldSendPositionEvent gate).
//
// The probe (all times performance.now() of THIS page — the recorder's clock):
//   - first sight: a vehicle guid not known at arm() shows up in window.__vehicles (profile/state) and in the entity
//     map; its server position (the state's cell + local x/y) and the distance to this player are logged;
//   - the pilot page's position arrives on a BroadcastChannel (film-hellcat.eval.js, run.channel); when armed with
//     stepAtM, the probe sidesteps (synthetic key events: ui/input-funnel.js is one document-level capture listener
//     keyed on ev.code) once the pilot is within stepAtM, and once more (step2) if nothing was seen retryMs later;
//   - the first kill: victims[0]'s rig held in its Dead pose (entityManager.isDeathHeld) or its corpse;
//   - the in-page stop: stopAfterKillMs after that kill (or at once if THIS player dies) the recorder's postRender
//     grab is unsubscribed (window.__hbVid.unsub) — no CDP round trip, so the cut lands before the dying player's
//     body is swapped for its corpse late and before any portal-space screen;
//   - one row a second while recording: recorder grid frames / held slots / encoder queue.
// window.__vehicleRun: {channel, victims: [names], pilotName}
const R = window.__vehicleRun || {};
try { window.__groundProbe?.dispose?.(); } catch (_) { /* a stale probe */ }
const L = window.liveScene3d, V = window.__vehicles;
if (!L || !V || !window.__cam) return { ok: false, fatal: "liveScene3d / __vehicles / __cam (camDebug) missing" };
const em = L.entityManager;
const now = () => performance.now();
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const norm = (n) => String(n ?? "").replace(/^\+/, "");
const me = () => { const p = window.__cam.world(); return p ? { x: r2(p.x), y: r2(p.y), z: r2(p.z) } : null; };
const dist2 = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null);
const findByName = (name) => {
  for (const [g, inst] of em.entityMap) if (norm(inst.meta?.name) === norm(name)) return { guid: g >>> 0, inst };
  return null;
};
const corpseOf = (name) => {
  for (const inst of em.entityMap.values()) { const n = String(inst.meta?.name ?? ""); if (n.startsWith("Corpse of ") && norm(n.slice(10)) === norm(name)) return true; }
  return false;
};
const vGlobal = (m) => (m ? { x: r2(((m.cell >>> 24) & 0xff) * 192 + m.x), y: r2(((m.cell >>> 16) & 0xff) * 192 + m.y), z: r2(m.z) } : null);
const localGuid = () => ((window.getLocalPlayerGuid?.() ?? 0) >>> 0);
const deathHeld = (guid) => { try { return !!(guid && em.isDeathHeld?.(guid)); } catch (_) { return false; } };

const st = {
  cfg: { stepAtM: 0, step2AtM: 0, stepDir: "left", step2Dir: "right", stepMs: 450, retryMs: 1000, stopAfterKillMs: 3000 },
  armed: false, tArm: null, known: new Set(), log: [], steps: [], seen: null, seenEntity: null, pilotBody: null,
  kills: [], selfDead: null, stopped: null, rows: [], pilot: null, bcCount: 0, lastRow: 0,
};
const ev = (kind, extra = {}) => { const e = { kind, t: r2(now()), ...extra }; st.log.push(e); return e; };

const KEYS = { left: "KeyA", right: "KeyD", forward: "KeyW", back: "KeyS" };
const key = (type, code) => document.dispatchEvent(new KeyboardEvent(type, { code, key: code.slice(3).toLowerCase(), bubbles: true, cancelable: true, composed: true }));
function step(dir, ms, why) {
  const code = KEYS[dir] || KEYS.left;
  const before = me();
  const rec = { why: why ?? null, dir, ms, tDown: r2(now()), before, pilotDist: r2(dist2(st.pilot, before)), tUp: null, after: null, moved: null };
  st.steps.push(rec);
  // a focused text field owns the keys (the funnel's text-entry deference): nothing may hold focus
  try { const a = document.activeElement; if (a && a !== document.body && typeof a.blur === "function") a.blur(); } catch (_) { /* */ }
  key("keydown", code);
  setTimeout(() => {
    key("keyup", code);
    rec.tUp = r2(now());
    setTimeout(() => { rec.after = me(); rec.moved = r2(dist2(rec.after, rec.before)); }, 800);
  }, Math.max(30, ms));
  ev(why || "step", { dir, ms, pilotDist: rec.pilotDist });
  return rec;
}

function sight(kind, v, inEm) {
  const p = me(), vp = vGlobal(v.last);
  const e = ev(kind, {
    guid: "0x" + (v.guid >>> 0).toString(16), via: inEm ? "entity" : "vehicles", vehicle: vp, me: p,
    dist2d: r2(dist2(vp, p)), dist3d: vp && p ? r2(Math.hypot(vp.x - p.x, vp.y - p.y, vp.z - p.z)) : null,
    pilotDist: r2(dist2(st.pilot, p)), pilotAgeMs: st.pilot ? r2(now() - st.pilot.tr) : null,
    msAfterStep: st.steps.length ? r2(now() - st.steps[st.steps.length - 1].tDown) : null,
    steps: st.steps.length,
  });
  return e;
}

function tick() {
  const t = now();
  // first sight of a vehicle unknown at arm()
  for (const v of V.vehicles?.() ?? []) {
    const g = v.guid >>> 0;
    if (st.known.has(g)) continue;
    const inEm = em.entityMap.has(g);
    if (!st.seen && (v.last || v.profile || inEm)) st.seen = sight("firstSight", v, inEm);
    if (!st.seenEntity && inEm) st.seenEntity = sight("firstSightEntity", v, true);
  }
  // the pilot's body (a seated player): when it first appears here
  if (!st.pilotBody && R.pilotName && findByName(R.pilotName)) st.pilotBody = ev("pilotBody", { pilotDist: r2(dist2(st.pilot, me())) });
  // kills, in order
  for (const name of R.victims || []) {
    if (st.kills.some((k) => k.victim === name)) continue;
    const e = findByName(name);
    const held = e && deathHeld(e.guid);
    if (held || corpseOf(name)) st.kills.push(ev(`kill${st.kills.length + 1}`, { victim: name, via: held ? "deathHold" : "corpse" }));
  }
  if (!st.selfDead && deathHeld(localGuid())) st.selfDead = ev("selfDead");
  // the in-page stop of the grab
  const vid = window.__hbVid;
  if (!st.stopped && st.armed && vid?.unsub) {
    const k = st.kills[0];
    if (st.selfDead || (k && t - k.t >= st.cfg.stopAfterKillMs)) {
      try { vid.unsub(); } catch (_) { /* */ }
      vid.unsub = null;
      st.stopped = ev("grabStopped", { why: st.selfDead ? "selfDead" : `kill1+${st.cfg.stopAfterKillMs}ms`, frames: vid.frames, held: vid.held });
    }
  }
  // one row a second while the recorder runs
  if (vid?.unsub && t - st.lastRow >= 1000) {
    st.lastRow = t;
    let vq = null;
    try { vq = vid.rec.stats().encodeQueueSize; } catch (_) { vq = null; }
    st.rows.push({ t: r2(t), vf: vid.frames, vh: vid.held, vq, pilotDist: r2(dist2(st.pilot, me())), seen: !!st.seen });
  }
}

let bc = null;
try {
  bc = new BroadcastChannel(R.channel || "hb-film");
  bc.onmessage = (m) => {
    const d = m.data;
    if (!d || typeof d.x !== "number") return;
    st.pilot = { ...d, tr: now() };
    st.bcCount++;
    if (!st.armed || st.seen || !(st.cfg.stepAtM > 0)) return;
    const dd = dist2(st.pilot, me());
    if (dd == null) return;
    const s1 = st.steps.find((s) => s.why === "step1");
    if (!s1) { if (dd <= st.cfg.stepAtM) step(st.cfg.stepDir, st.cfg.stepMs, "step1"); return; }
    if (st.cfg.step2AtM > 0 && !st.steps.some((s) => s.why === "step2") && s1.tUp != null && now() - s1.tUp >= st.cfg.retryMs && dd <= st.cfg.step2AtM) {
      step(st.cfg.step2Dir, st.cfg.stepMs, "step2");
    }
  };
} catch (e) { ev("bcError", { error: String(e) }); }
const timer = setInterval(() => { try { tick(); } catch (e) { if (st.log.length < 400) ev("tickError", { error: String(e) }); } }, 50);

window.__groundProbe = {
  me, step,
  /** start a measurement: vehicles known now are ignored; cfg: stepAtM (0 = no auto step), step2AtM, stepDir,
   *  step2Dir, stepMs, retryMs, stopAfterKillMs */
  arm(cfg = {}) {
    Object.assign(st.cfg, cfg);
    st.known = new Set((V.vehicles?.() ?? []).map((v) => v.guid >>> 0));
    st.seen = null; st.seenEntity = null; st.pilotBody = null; st.kills = []; st.selfDead = null; st.stopped = null;
    st.steps = []; st.rows = []; st.armed = true; st.tArm = r2(now());
    ev("arm", { cfg: { ...st.cfg }, known: st.known.size, me: me() });
    return { tArm: st.tArm, known: st.known.size, me: me() };
  },
  disarm() { st.armed = false; return true; },
  /** entities farther than r m (2D, rig world positions) from this player: only the server's wide observer sight
   *  admits them, so the count grows with each wide-sight cell change until everything inside the radius is in */
  farCount(r = 112.5) {
    const self = em.entityMap.get(localGuid());
    if (!self?.root) return null;
    const o = self.root.position.clone(); self.root.getWorldPosition(o);
    const w = o.clone();
    let n = 0;
    for (const inst of em.entityMap.values()) {
      if (!inst.root || !inst.root.parent) continue;
      inst.root.getWorldPosition(w);
      if (Math.hypot(w.x - o.x, w.z - o.z) > r) n++;
    }
    return n;
  },
  /** the cheap poll (a few bytes over CDP) */
  status() { return { seen: st.seen ? st.seen.dist2d : null, kills: st.kills.length, stopped: !!st.stopped, selfDead: !!st.selfDead, steps: st.steps.length, bc: st.bcCount }; },
  report() {
    return {
      cfg: { ...st.cfg }, armed: st.armed, tArm: st.tArm, timeOrigin: performance.timeOrigin, now: r2(now()), me: me(),
      seen: st.seen, seenEntity: st.seenEntity, pilotBody: st.pilotBody, steps: st.steps, kills: st.kills,
      selfDead: st.selfDead, stopped: st.stopped, rows: st.rows, pilot: st.pilot, bcCount: st.bcCount, log: st.log.slice(-300),
    };
  },
  dispose() { clearInterval(timer); try { bc?.close(); } catch (_) { /* */ } st.armed = false; return true; },
};
return { ok: true, installed: true, me: me(), timeOrigin: performance.timeOrigin };
