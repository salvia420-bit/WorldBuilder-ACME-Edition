#!/usr/bin/env node
// rynth_portal_hold_test.cjs — the movers hold while the client shows portal
// space (2026-10-12; rynth/portal_gate.js, router.js PORTAL hold).
//
// Since 1aedd85c a teleport runs retail's portal-space tunnel, and 0d06b92e's
// ?portalHoldBuild keeps it up while the destination interior builds. The old
// router resumed after a fixed 4 s settle and walked into cells whose collision
// had not landed. This pins:
//   - router: a tunnel that starts mid-walk parks the route (no MoveTo re-issue),
//     status.portalHold + status.ticks report it, a teleport that lands under it
//     consumes the portal leg, a tunnel that ends where it began re-walks the
//     same leg, a stuck flag is capped and then ignored until it clears, and a
//     route started inside portal space issues nothing until it ends;
//   - the legacy no-portal-space path (nullRender / ?portalSpace=off) is unchanged;
//   - walk polls (goto_compose walkLegs) treat a ticking hold as progress but
//     still fail a frozen host;
//   - unwedge does not count a portal-space hold as commanded movement, and the
//     explore-pressure controller starts no idle hop under the tunnel.
// Plain node, no infra. Run: node rynth_portal_hold_test.cjs

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const imp = (rel) => import(pathToFileURL(path.join(__dirname, rel)).href);

// Landblock-local frame helpers: lb 0x10100000 (lbX=16,lbY=16), outdoor cell 1.
const NEAR = 0x10100001;
const FAR = 0x40400001; // a different landblock, thousands of metres away

function mkHost(pose) {
  const h = {
    pose,
    moves: [],
    stops: 0,
    TryGetPlayerPose: () => h.pose,
    MoveToPosition(cell, x, y, z, run) { h.moves.push({ cell: cell >>> 0, x, y, z, run }); return true; },
    StopCompletely() { h.stops += 1; return true; },
    GetPursuitStatus: () => ({ now: 0, last: 0 }),
  };
  return h;
}

(async () => {
  const gate = await imp("rynth/portal_gate.js");
  const { RynthRouter } = await imp("rynth/router.js");
  const gc = await imp("rynth/goto_compose.js");
  const { UnwedgeReflex } = await imp("rynth/unwedge.js");
  const botMod = await imp("rynth/bot.js");

  // ── portal_gate ───────────────────────────────────────────────────────────
  {
    check("gate: no host method, no page global -> false", gate.portalSpaceActive(null) === false);
    check("gate: host.IsPortalSpaceActive() wins", gate.portalSpaceActive({ IsPortalSpaceActive: () => true }) === true);
    globalThis.__isPortalSpaceActive = () => true;
    check("gate: page global read when the host has no method", gate.portalSpaceActive({}) === true);
    globalThis.__isPortalSpaceActive = () => { throw new Error("boom"); };
    check("gate: a throwing global reads false (never parks the bot on an error)", gate.portalSpaceActive({}) === false);
    delete globalThis.__isPortalSpaceActive;
    check("holdIsAlive: ticking hold = alive", gate.holdIsAlive({ portalHold: true, ticks: 5 }, 4) === true);
    check("holdIsAlive: frozen ticks = not alive", gate.holdIsAlive({ portalHold: true, ticks: 5 }, 5) === false);
    check("holdIsAlive: no hold = not alive", gate.holdIsAlive({ portalHold: false, ticks: 6 }, 5) === false);
    check("holdIsAlive: first poll (no prior ticks) = not alive", gate.holdIsAlive({ portalHold: true, ticks: 6 }, null) === false);
    check("holdIsAlive: stale router without fields = not alive", gate.holdIsAlive({ state: "PORTAL" }, 3) === false);
  }

  // ── router: tunnel mid-walk, teleport lands under it, portal leg consumed ──
  {
    const host = mkHost({ objCellId: NEAR, x: 10, y: 10, z: 0 });
    let portal = false;
    const arrived = [];
    const r = new RynthRouter(host, {
      log: () => {}, settleMs: 20, portalSpaceActive: () => portal,
      onArrive: (i) => arrived.push(i),
    });
    r.follow([
      { lb: NEAR, x: 60, y: 10, z: 0, portal: true }, // walk to the portal
      { lb: FAR, x: 20, y: 20, z: 0 },                 // far side
    ]);
    check("router: first leg issued", host.moves.length === 1);
    r.tick();
    check("router: walking normally before the tunnel", r.status.state === "WALK" && r.status.portalHold === false);
    portal = true; // PlayerTeleport -> tunnel up; the far-side pose has NOT landed yet
    const stopsBefore = host.stops;
    r.tick();
    check("router: tunnel mid-walk -> PORTAL hold", r.status.state === "PORTAL" && r.status.portalHold === true, JSON.stringify(r.status));
    check("router: entering the hold stops the body", host.stops === stopsBefore + 1);
    const movesAtHold = host.moves.length;
    const t0 = r.status.ticks;
    for (let i = 0; i < 5; i++) { await sleep(8); r.tick(); }
    check("router: no MoveToPosition while held (even past settleMs)", host.moves.length === movesAtHold);
    check("router: ticks advance through the hold", r.status.ticks === t0 + 5, `${t0} -> ${r.status.ticks}`);
    host.pose = { objCellId: FAR, x: 18, y: 18, z: 0 }; // teleport lands under the tunnel
    r.tick();
    check("router: still held while the tunnel is up", r.status.state === "PORTAL" && host.moves.length === movesAtHold);
    portal = false; // destination built, tunnel drops
    r.tick();
    check("router: tunnel end after a hold longer than settle -> resumes at once", r.status.state === "WALK", JSON.stringify(r.status));
    check("router: portal leg consumed (walked 1, onArrive fired for leg 0)", r.status.walked === 1 && arrived.join() === "0", JSON.stringify({ s: r.status, arrived }));
    const last = host.moves[host.moves.length - 1];
    check("router: walking the far-side leg", r.status.leg === 1 && last && last.cell === FAR, JSON.stringify(last));
    check("router: hold flag cleared after resume", r.status.portalHold === false);
  }

  // ── router: tunnel that ends without a teleport -> same leg re-walked ──────
  {
    const host = mkHost({ objCellId: NEAR, x: 10, y: 10, z: 0 });
    let portal = false;
    const r = new RynthRouter(host, { log: () => {}, settleMs: 10, portalSpaceActive: () => portal });
    r.follow([{ lb: NEAR, x: 60, y: 10, z: 0, portal: true }, { lb: FAR, x: 20, y: 20, z: 0 }]);
    r.tick();
    portal = true;
    r.tick();
    portal = false;
    await sleep(15);
    r.tick();
    const last = host.moves[host.moves.length - 1];
    check("router: no-hop tunnel -> WALK on the SAME leg, nothing consumed",
      r.status.state === "WALK" && r.status.leg === 0 && r.status.walked === 0 && last.x === 60, JSON.stringify({ s: r.status, last }));
  }

  // ── router: stuck flag capped, then ignored until it clears ──────────────
  {
    const host = mkHost({ objCellId: NEAR, x: 10, y: 10, z: 0 });
    let portal = false;
    const r = new RynthRouter(host, { log: () => {}, settleMs: 5, portalSpaceMaxMs: 30, portalSpaceActive: () => portal });
    r.follow([{ lb: NEAR, x: 60, y: 10, z: 0 }]);
    r.tick();
    portal = true; // and it never clears
    r.tick();
    check("router: stuck flag -> held at first", r.status.state === "PORTAL" && r.status.portalHold === true);
    await sleep(40);
    r.tick(); // past the cap: resume anyway
    r.tick();
    check("router: past portalSpaceMaxMs -> resumes walking despite the flag", r.status.state === "WALK" && r.status.portalHold === false, JSON.stringify(r.status));
    const n = host.moves.length;
    r.tick();
    r.tick();
    check("router: a capped flag does not re-park the walk", r.status.state === "WALK" && host.moves.length >= n);
    portal = false;
    r.tick(); // flag clears -> the next tunnel is honoured again
    portal = true;
    r.tick();
    check("router: after the flag clears, a new tunnel holds again", r.status.state === "PORTAL" && r.status.portalHold === true, JSON.stringify(r.status));
  }

  // ── router: a route started inside portal space issues nothing ───────────
  {
    const host = mkHost({ objCellId: FAR, x: 18, y: 18, z: 0 });
    let portal = true;
    const r = new RynthRouter(host, { log: () => {}, settleMs: 5, portalSpaceActive: () => portal });
    r.follow([{ lb: FAR, x: 60, y: 18, z: 0 }]);
    check("router: follow() in portal space -> PORTAL hold, no MoveToPosition", r.status.state === "PORTAL" && host.moves.length === 0, JSON.stringify({ s: r.status, moves: host.moves.length }));
    r.tick();
    check("router: still nothing issued while the tunnel holds", host.moves.length === 0);
    portal = false;
    await sleep(10);
    r.tick();
    check("router: tunnel ends -> the leg is issued", r.status.state === "WALK" && host.moves.length === 1 && host.moves[0].x === 60, JSON.stringify(host.moves));
  }

  // ── router: legacy path (no portal space) unchanged ──────────────────────
  {
    const host = mkHost({ objCellId: NEAR, x: 10, y: 10, z: 0 });
    const r = new RynthRouter(host, { log: () => {}, settleMs: 25 }); // real gate: no global -> never holds
    r.follow([{ lb: NEAR, x: 60, y: 10, z: 0, portal: true }, { lb: FAR, x: 20, y: 20, z: 0 }]);
    r.tick();
    host.pose = { objCellId: FAR, x: 18, y: 18, z: 0 }; // teleport detected by the pose jump
    r.tick();
    check("legacy: pose jump -> PORTAL settle (no hold flag)", r.status.state === "PORTAL" && r.status.portalHold === false);
    const n = host.moves.length;
    r.tick();
    check("legacy: inside the settle window nothing is issued", r.status.state === "PORTAL" && host.moves.length === n);
    await sleep(30);
    r.tick();
    check("legacy: after the settle -> resumes on the far side, portal leg consumed",
      r.status.state === "WALK" && r.status.walked === 1 && host.moves[host.moves.length - 1].cell === FAR, JSON.stringify(r.status));
  }

  // ── walkLegs: a ticking hold is progress, a frozen host still stalls ──────
  {
    let ticks = 0;
    let frozen = false;
    let done = false;
    const router = {
      follow() {},
      cancel() { this.cancelled = true; },
      get status() {
        if (done) return { state: "DONE", leg: 1, legs: 1, walked: 1, portalHold: false, ticks };
        if (!frozen) ticks += 1;
        return { state: "PORTAL", leg: 0, legs: 1, walked: 0, portalHold: true, ticks };
      },
    };
    setTimeout(() => { done = true; }, 60);
    const r1 = await gc.walkLegs(router, [{ lb: NEAR, x: 1, y: 1, z: 0 }], { pollMs: 2, stallMs: 20 });
    check("walkLegs: a 60 ms ticking hold outlives a 20 ms stallMs (not STALLED)", r1.ok === true && r1.state === "DONE", JSON.stringify(r1));
    done = false;
    frozen = true;
    const r2 = await gc.walkLegs(router, [{ lb: NEAR, x: 1, y: 1, z: 0 }], { pollMs: 2, stallMs: 20 });
    check("walkLegs: a hold whose ticks froze still STALLS (host stopped ticking)", r2.ok === false && r2.state === "STALLED", JSON.stringify(r2));
  }

  // ── unwedge: a portal-space hold is not commanded movement ───────────────
  {
    const host = { TryGetPlayerPose: () => ({ objCellId: NEAR, x: 1, y: 1, z: 0, cellResolved: true }), GetCastBusyState: () => 0 };
    const reflex = new UnwedgeReflex(host, { log: () => {} });
    reflex.bot = { router: { status: { state: "WALK" } }, loot: { state: "APPROACH" } };
    check("unwedge: router WALK = commanded", reflex._commanded() === true);
    host.IsPortalSpaceActive = () => true;
    check("unwedge: same, but in portal space = NOT commanded", reflex._commanded() === false);
  }

  // ── explore pressure: no idle hop under the tunnel ───────────────────────
  {
    const host = { TryGetPlayerPose: () => ({ objCellId: NEAR, x: 1, y: 1, z: 0 }) };
    const router = { status: { state: "IDLE" } };
    const ctl = new botMod.ExplorePressureController(host, router, {}, { isOperatorStopLatched: () => false }, { now: () => 1_000_000 });
    ctl.bot = { ai: { director: { enabled: true, isBusy: () => false } }, movementClaimed: () => false };
    ctl._lastMoveAt = 0;
    ctl._lastStepAt = 0;
    check("explore: gates open on an idle bot", ctl._gatesOpen(1_000_000) === true);
    check("explore: nothing claims the route", ctl._routeClaimed() === false);
    host.IsPortalSpaceActive = () => true;
    check("explore: gates CLOSED in portal space", ctl._gatesOpen(1_000_000) === false);
    check("explore: mid-step re-check sees the tunnel as a claim", ctl._routeClaimed() === true);
  }

  console.log(`\nportal_hold: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
