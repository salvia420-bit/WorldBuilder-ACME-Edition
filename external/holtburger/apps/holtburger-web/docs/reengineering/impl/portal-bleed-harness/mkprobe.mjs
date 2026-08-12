#!/usr/bin/env node
// mkprobe.mjs — lane B, RESUME #2: the ADVERSARIAL arm for the punchSidedness
// default-flip (master 421cdf0a).
//
// The flip shipped with a named, unclosed residual risk: "a ground-level
// doorway-reveal check I have no frame for". The prior evidence proved the gate
// correctly STOPS a punch that must not happen (window through a roof). It did
// NOT prove the gate still ALLOWS a punch that MUST happen. This job attacks
// that converse.
//
// TWO INDEPENDENT ATTACKS, in one boot:
//
//   1. CENSUS (analytic, every resident aperture — not 8 camera angles).
//      The shipped gate drops an aperture when the camera is on the side
//      `portal_side` names. `portal_side` is asserted to name the owning room's
//      INTERIOR (15,186/15,186 in holtburger-dat cell_portal_flags_parity.rs) —
//      but that assertion is measured in DAT space. The live gate applies the
//      plane in AC WORLD space, after the wasm->world transform. That link is
//      the untested one, and a reflection anywhere in it silently INVERTS the
//      gate, which would cull exactly the doorways you stand in front of.
//      Independent witness: the owning cell's AABB centre, which the v3 export
//      carries alongside portal_side. A camera AT the cell centre is inside the
//      room, so the gate MUST drop it. Any aperture where it does not is a
//      sign inversion in world space.
//      HONESTY: the AABB centre is itself the unreliable round-5 heuristic
//      (a doorway in a long wall puts it near the plane; an L-shaped cell can
//      put it outside the room). So disagreement is only damning when the
//      centre is a STRONG witness — well off the plane. Bucketed accordingly,
//      and never collapsed to a single pass/fail.
//
//   2. SQUARE-ON DOORWAY FRAMES (the owner's requirement). For real apertures
//      picked at runtime, the camera is placed on the far side of the plane
//      from the cell centre — i.e. OUTSIDE the room by construction, derived
//      from geometry rather than from the gate's own verdict, so the test is
//      not circular — at close range, looking straight down the normal at the
//      aperture centroid. That is the "you are standing in the doorway" shot
//      the residual risk asks for. `__cam.set(eye, lookAt)` takes AC world
//      metres directly (camera.js:1228), so no azimuth convention is guessed.
//
// usage: node mkprobe.mjs <arm> <default|on|off|heuristic>

import fs from "node:fs";

const [, , ARM, MODE] = process.argv;
if (!ARM || !MODE) {
  console.error("usage: node mkprobe.mjs <arm> <default|on|off|heuristic>");
  process.exit(1);
}

const PORT_SERVE = 8772;
const PORT_CDP = 9342;
const ACCOUNT = "agentp09";

const q = [
  "nosw=1",
  "autoLogin=1",
  "autoSpawn=first",
  "agent=1",
  "skytime=12",
  "camDebug=on",
  "renderScale=1",
  `account=${ACCOUNT}`,
  `password=${ACCOUNT}`,
  `bridge_url=${encodeURIComponent("ws://100.116.47.66:8080/")}`,
];
if (MODE !== "default") q.push(`punchSidedness=${MODE}`);
const url = `http://127.0.0.1:${PORT_SERVE}/apps/holtburger-web/index.html?${q.join("&")}`;

const DIAG =
  "(()=>{const d=window.liveScene3d?._portalPunchDiag; return d?JSON.parse(JSON.stringify(d)):'<absent>';})()";

// ── load the SHIPPED gate, so the census tests product code, not a copy ──────
const LOADMOD = `
import('/apps/holtburger-web/scene3d/portal_clip.js').then(m=>{
  window.__pc = m;
  return {keys: Object.keys(m).length,
          hasSide: typeof m.apertureFacesAwayWithSide === 'function'};
}).catch(e=>'<import-failed:'+e+'>')`;

// ── find camera + worldRoot and compose the same MVP cells.js:2724 composes ──
const MVP = `
window.__mkMvp = function(){
  const s = window.liveScene3d; if(!s) return null;
  const cam = s.activeCamera || s.camera || null;
  let wr = s.worldRoot || s._worldRoot || null;
  if (!wr && s.scene && s.scene.children) {
    for (const c of s.scene.children) if (c.name === 'worldRoot') { wr = c; break; }
  }
  if (!cam || !wr) return null;
  cam.updateMatrixWorld(true); wr.updateMatrixWorld(true);
  const mul = (a,b)=>{ const o=new Array(16);
    for(let c=0;c<4;c++) for(let r=0;r<4;r++){ let v=0;
      for(let k=0;k<4;k++) v += a[k*4+r]*b[c*4+k]; o[c*4+r]=v; }
    return o; };
  const pv = mul(cam.projectionMatrix.elements, cam.matrixWorldInverse.elements);
  return mul(pv, wr.matrixWorld.elements);
};
(()=>{ const m = window.__mkMvp(); return m ? 'ok' : '<no-cam-or-worldRoot>'; })()`;

// ── decode the v3 buffer (portal_clip.js:826-854 is the format of record) ────
const DECODE = `
window.__apertures = function(){
  const s = window.liveScene3d, sh = s && s.sessionHandle;
  if (!sh) return {err:'no-handle'};
  if (typeof sh.getVisiblePortalAperturesWithSidedness !== 'function') return {err:'no-v3-export'};
  const mvp = window.__mkMvp(); if (!mvp) return {err:'no-mvp'};
  const flat = sh.getVisiblePortalAperturesWithSidedness(mvp, 0);
  if (!flat || !flat.length) return {err:'empty-buffer'};
  let k = 0; const count = flat[k++]|0; const out = [];
  for (let a=0; a<count; a++){
    const nv = flat[k++]|0;
    const cc = {x:flat[k],y:flat[k+1],z:flat[k+2]}; k+=3;   // v3 carries the centre
    const portalSide = flat[k] === 1; k+=1;                  // strict ===1, as shipped
    const start = k; k += nv*3;
    if (nv < 3 || k > flat.length) continue;
    const pts = []; for (let i=0;i<nv*3;i++) pts.push(flat[start+i]);
    let cx=0, cy=0, cz=0;
    for (let i=0;i<nv;i++){ cx+=pts[i*3]; cy+=pts[i*3+1]; cz+=pts[i*3+2]; }
    out.push({nv, cc, portalSide, pts, centroid:{x:cx/nv, y:cy/nv, z:cz/nv}});
  }
  return {count, parsed: out.length, aps: out};
};
(()=>{ const r = window.__apertures(); return r.err ? r : {count:r.count, parsed:r.parsed}; })()`;

// ── THE CENSUS ───────────────────────────────────────────────────────────────
// For every aperture: is the owning cell's centre on the side the gate DROPS?
// It must be. `dist` is the centre's distance off the aperture plane and is the
// witness strength — a near-plane centre is the known-bad round-5 case and is
// bucketed out rather than counted as evidence either way.
const CENSUS = `
(()=>{
  const pc = window.__pc; if(!pc) return '<no-module>';
  const r = window.__apertures(); if (r.err) return r;
  const faces = pc.apertureFacesAwayWithSide;
  const plane = (pts)=>{ // Newell, matching polygonPlane's orientation
    const n = pts.length/3; let nx=0,ny=0,nz=0;
    for(let i=0;i<n;i++){ const j=(i+1)%n;
      const ax=pts[i*3],ay=pts[i*3+1],az=pts[i*3+2];
      const bx=pts[j*3],by=pts[j*3+1],bz=pts[j*3+2];
      nx+=(ay-by)*(az+bz); ny+=(az-bz)*(ax+bx); nz+=(ax-bx)*(ay+by); }
    const L=Math.hypot(nx,ny,nz)||1; return {nx:nx/L,ny:ny/L,nz:nz/L};
  };
  const B = {strong:{ok:0,bad:0}, weak:{ok:0,bad:0}, degenerate:0};
  const offenders = [];
  for (const a of r.aps){
    const pl = plane(a.pts);
    const d = pl.nx*(a.cc.x-a.centroid.x) + pl.ny*(a.cc.y-a.centroid.y) + pl.nz*(a.cc.z-a.centroid.z);
    if (!isFinite(d)) { B.degenerate++; continue; }
    // The gate's own verdict for a camera sitting AT the owning cell centre.
    const dropAtCentre = !!faces(a.pts, a.portalSide, a.cc, 0);
    // And for its mirror image through the plane — outside the room.
    const out = {x:a.cc.x-2*d*pl.nx, y:a.cc.y-2*d*pl.ny, z:a.cc.z-2*d*pl.nz};
    const dropOutside = !!faces(a.pts, a.portalSide, out, 0);
    const strong = Math.abs(d) >= 2.0;   // metres off the plane
    const ok = dropAtCentre && !dropOutside;
    B[strong?'strong':'weak'][ok?'ok':'bad']++;
    if (!ok && strong && offenders.length < 12)
      offenders.push({centroid:{x:+a.centroid.x.toFixed(1),y:+a.centroid.y.toFixed(1),z:+a.centroid.z.toFixed(1)},
                      cc:{x:+a.cc.x.toFixed(1),y:+a.cc.y.toFixed(1),z:+a.cc.z.toFixed(1)},
                      portalSide:a.portalSide, dCentre:+d.toFixed(2),
                      dropAtCentre, dropOutside, nv:a.nv});
  }
  return {parsed:r.parsed, buckets:B, offenders};
})()`;

// ── pick square-on doorway shots, derived from geometry not from the gate ────
// Camera goes on the OPPOSITE side of the plane from the cell centre => outside
// the room by construction. Ground-level apertures preferred (|z - player z|
// small), largest first so the aperture actually fills some pixels.
const PICK = `
(()=>{
  const r = window.__apertures(); if (r.err) return r;
  const pz = (window.__wpos && window.__wpos.wz) || 0;
  const plane = (pts)=>{ const n=pts.length/3; let nx=0,ny=0,nz=0;
    for(let i=0;i<n;i++){ const j=(i+1)%n;
      const ax=pts[i*3],ay=pts[i*3+1],az=pts[i*3+2];
      const bx=pts[j*3],by=pts[j*3+1],bz=pts[j*3+2];
      nx+=(ay-by)*(az+bz); ny+=(az-bz)*(ax+bx); nz+=(ax-bx)*(ay+by); }
    const L=Math.hypot(nx,ny,nz)||1; return {nx:nx/L,ny:ny/L,nz:nz/L}; };
  const area = (pts)=>{ // rough: bbox diagonal, enough to rank
    let x0=1e9,y0=1e9,z0=1e9,x1=-1e9,y1=-1e9,z1=-1e9; const n=pts.length/3;
    for(let i=0;i<n;i++){ const x=pts[i*3],y=pts[i*3+1],z=pts[i*3+2];
      x0=Math.min(x0,x);y0=Math.min(y0,y);z0=Math.min(z0,z);
      x1=Math.max(x1,x);y1=Math.max(y1,y);z1=Math.max(z1,z); }
    return Math.hypot(x1-x0,y1-y0,z1-z0); };
  const cand = [];
  for (const a of r.aps){
    const pl = plane(a.pts);
    const d = pl.nx*(a.cc.x-a.centroid.x)+pl.ny*(a.cc.y-a.centroid.y)+pl.nz*(a.cc.z-a.centroid.z);
    if (!isFinite(d) || Math.abs(d) < 1.0) continue;   // need a clear inside
    const sgn = d > 0 ? -1 : 1;                        // AWAY from the cell centre
    const sz = area(a.pts);
    if (sz < 1.5) continue;                            // skip slivers
    const dz = Math.abs(a.centroid.z - pz);
    cand.push({c:a.centroid, n:{x:pl.nx*sgn,y:pl.ny*sgn,z:pl.nz*sgn}, sz, dz, ps:a.portalSide});
  }
  // ground-level first, then biggest
  cand.sort((p,q)=> (p.dz - q.dz) || (q.sz - p.sz));
  const picks = cand.slice(0, 4).map((p,i)=>({
    tag:'door'+(i+1),
    eye:{x:+(p.c.x+p.n.x*6).toFixed(2), y:+(p.c.y+p.n.y*6).toFixed(2), z:+(p.c.z+p.n.z*6 + 0.4).toFixed(2)},
    at:{x:+p.c.x.toFixed(2), y:+p.c.y.toFixed(2), z:+p.c.z.toFixed(2)},
    sz:+p.sz.toFixed(2), dz:+p.dz.toFixed(2), portalSide:p.ps }));
  window.__picks = picks;
  return {cands:cand.length, picks};
})()`;

const steps = [
  { op: "plateau", minLbs: 10 },
  { op: "eval", name: "loadmod", expr: LOADMOD },
  { op: "chat", text: "@telepoi Holtburg", settleMs: 14000 },
  { op: "plateau", minLbs: 10 },
  { op: "wait", ms: 10000 },
  {
    op: "eval",
    name: "worldPose",
    expr:
      "(()=>{const p=window.liveScene3d?.sessionHandle?.getLocalPlayerPose?.();" +
      "if(!p) return '<no-pose>';const lb=p.landblockId>>>0;" +
      "const wx=((lb>>>24)&0xff)*192+p.x, wy=((lb>>>16)&0xff)*192+p.y, wz=p.z;" +
      "try{p.free?.()}catch(e){}window.__wpos={wx,wy,wz};" +
      "return {lb:'0x'+lb.toString(16),wx:+wx.toFixed(2),wy:+wy.toFixed(2),wz:+wz.toFixed(2)};})()",
  },
  { op: "eval", name: "mvp", expr: MVP },
  { op: "eval", name: "decode", expr: DECODE },
  { op: "eval", name: "census", expr: CENSUS },
  { op: "eval", name: "gatesDiag", expr: DIAG },
  { op: "eval", name: "picks", expr: PICK },
];

// four square-on doorway shots, same picks in both arms (geometry-derived, so
// the two arms choose the same apertures independently of the flag)
for (let i = 1; i <= 4; i++) {
  steps.push({
    op: "eval",
    name: `cam-door${i}`,
    expr:
      `(()=>{const p=(window.__picks||[])[${i - 1}]; if(!p) return '<no-pick>';` +
      `window.__cam.set(p.eye.x,p.eye.y,p.eye.z,p.at.x,p.at.y,p.at.z); return p;})()`,
  });
  steps.push({ op: "wait", ms: 5000 });
  steps.push({ op: "shot", name: `${ARM}-door${i}` });
  steps.push({ op: "eval", name: `diag-door${i}`, expr: DIAG });
}

const job = {
  arm: ARM,
  url,
  port: PORT_CDP,
  outDir: "/home/wbterminal/fanout-s12/B/eyetest-B/out",
  viewport: [1280, 800],
  hardTimeoutMs: 1500000,
  steps,
};

const out = `/home/wbterminal/fanout-s12/B/eyetest-B/${ARM}.json`;
fs.writeFileSync(out, JSON.stringify(job, null, 1));
console.log(out);
