#!/usr/bin/env node
// mkaudit.mjs — lane B, RESUME #2. The converse-regression DETECTOR.
//
// mkprobe.mjs proved the world-space SIGN is not inverted (census: 43/43, zero
// offenders). That is necessary but not sufficient: it says portal_side names
// the interior, it does not say the gate keeps the doorways a player actually
// stands in front of. This job answers that directly.
//
// THE AUDIT. At each real camera pose, for every aperture the shipped gate
// drops as `backface`, ask an INDEPENDENT question: is the camera actually
// inside the owning room? The witness is the owning cell's AABB centre, which
// the v3 export carries next to portal_side. Camera and cell centre on the SAME
// side of the aperture plane => the camera is in the room and the drop is
// correct (that is retail's far-side-door reject). Camera on the OPPOSITE side
// => the gate dropped an aperture the viewer is OUTSIDE of, which is the
// converse regression the flip shipped with as an open risk.
//
// Only |dist(cellCentre)| >= 2 m counts as evidence, because the AABB centre is
// the known-unreliable round-5 witness near the plane (doorway in a long wall,
// L-shaped cell). Near-plane cases are reported separately, never folded in.
//
// THE PICKS. Square-on doorway shots now require a WALL opening: |n.z| <= 0.35,
// i.e. a vertical-ish plane. The first pass picked apertures with near-VERTICAL
// normals (floor/ceiling holes) and an obelisk, which are not doorways and do
// not test the residual risk. Camera sits `STANDOFF` m down the outward normal
// at the aperture's own centre height — eye level for that doorway.
//
// usage: node mkaudit.mjs <arm> <default|on|off|heuristic> [picksJsonFile]
//   picksJsonFile forces camera poses (so both arms shoot the SAME cameras even
//   if their resident aperture sets differ).

import fs from "node:fs";

const [, , ARM, MODE, PICKS_FILE] = process.argv;
if (!ARM || !MODE) {
  console.error("usage: node mkaudit.mjs <arm> <default|on|off|heuristic> [picksJson]");
  process.exit(1);
}

const PORT_SERVE = 8772;
const PORT_CDP = 9342;
const ACCOUNT = "agentp09";
const STANDOFF = 5.0;

const q = [
  "nosw=1", "autoLogin=1", "autoSpawn=first", "agent=1", "skytime=12",
  "camDebug=on", "renderScale=1",
  `account=${ACCOUNT}`, `password=${ACCOUNT}`,
  `bridge_url=${encodeURIComponent("ws://100.116.47.66:8080/")}`,
];
if (MODE !== "default") q.push(`punchSidedness=${MODE}`);
const url = `http://127.0.0.1:${PORT_SERVE}/apps/holtburger-web/index.html?${q.join("&")}`;

const DIAG =
  "(()=>{const d=window.liveScene3d?._portalPunchDiag; return d?JSON.parse(JSON.stringify(d)):'<absent>';})()";

const LOADMOD = `
import('/apps/holtburger-web/scene3d/portal_clip.js').then(m=>{
  window.__pc = m;
  return {hasSide: typeof m.apertureFacesAwayWithSide === 'function'};
}).catch(e=>'<import-failed:'+e+'>')`;

const MVP = `
window.__mkMvp = function(){
  const s = window.liveScene3d; if(!s) return null;
  const cam = s.activeCamera || s.camera || null;
  let wr = s.worldRoot || s._worldRoot || null;
  if (!wr && s.scene && s.scene.children)
    for (const c of s.scene.children) if (c.name === 'worldRoot') { wr = c; break; }
  if (!cam || !wr) return null;
  cam.updateMatrixWorld(true); wr.updateMatrixWorld(true);
  const mul=(a,b)=>{const o=new Array(16);
    for(let c=0;c<4;c++)for(let r=0;r<4;r++){let v=0;
      for(let k=0;k<4;k++)v+=a[k*4+r]*b[c*4+k];o[c*4+r]=v;}return o;};
  return mul(mul(cam.projectionMatrix.elements, cam.matrixWorldInverse.elements), wr.matrixWorld.elements);
};
window.__plane = function(pts){ const n=pts.length/3; let nx=0,ny=0,nz=0;
  for(let i=0;i<n;i++){const j=(i+1)%n;
    const ax=pts[i*3],ay=pts[i*3+1],az=pts[i*3+2];
    const bx=pts[j*3],by=pts[j*3+1],bz=pts[j*3+2];
    nx+=(ay-by)*(az+bz); ny+=(az-bz)*(ax+bx); nz+=(ax-bx)*(ay+by);}
  const L=Math.hypot(nx,ny,nz)||1; return {nx:nx/L,ny:ny/L,nz:nz/L}; };
window.__apertures = function(){
  const s=window.liveScene3d, sh=s&&s.sessionHandle;
  if(!sh) return {err:'no-handle'};
  if(typeof sh.getVisiblePortalAperturesWithSidedness!=='function') return {err:'no-v3-export'};
  const mvp=window.__mkMvp(); if(!mvp) return {err:'no-mvp'};
  const flat=sh.getVisiblePortalAperturesWithSidedness(mvp,0);
  if(!flat||!flat.length) return {err:'empty-buffer'};
  let k=0; const count=flat[k++]|0; const out=[];
  for(let a=0;a<count;a++){
    const nv=flat[k++]|0;
    const cc={x:flat[k],y:flat[k+1],z:flat[k+2]}; k+=3;
    const portalSide=flat[k]===1; k+=1;
    const start=k; k+=nv*3;
    if(nv<3||k>flat.length) continue;
    const pts=[]; for(let i=0;i<nv*3;i++) pts.push(flat[start+i]);
    let cx=0,cy=0,cz=0;
    for(let i=0;i<nv;i++){cx+=pts[i*3];cy+=pts[i*3+1];cz+=pts[i*3+2];}
    out.push({nv,cc,portalSide,pts,centroid:{x:cx/nv,y:cy/nv,z:cz/nv}});
  }
  return {count,parsed:out.length,aps:out};
};
// THE DETECTOR. At the CURRENT camera, find apertures dropped by the shipped
// sidedness gate while the camera is on the far side of the plane from the
// owning room -- i.e. dropped while the viewer is OUTSIDE.
window.__audit = function(){
  const pc=window.__pc; if(!pc) return '<no-module>';
  const r=window.__apertures(); if(r.err) return r;
  const s=window.liveScene3d;
  const cam=s.activeCamera||s.camera;
  // three -> AC world. acToThree is (x,z,-y)-shaped; invert via worldRoot.
  let wr=s.worldRoot||s._worldRoot||null;
  if(!wr&&s.scene&&s.scene.children)
    for(const c of s.scene.children) if(c.name==='worldRoot'){wr=c;break;}
  if(!cam||!wr) return {err:'no-cam'};
  const p=cam.position.clone(); wr.updateMatrixWorld(true);
  const inv=wr.matrixWorld.clone().invert(); p.applyMatrix4(inv);
  const camAc={x:p.x,y:p.y,z:p.z};
  const faces=pc.apertureFacesAwayWithSide;
  let dropped=0, keptN=0, correctDrop=0, suspicious=0, nearPlane=0;
  const offenders=[];
  for(const a of r.aps){
    const pl=window.__plane(a.pts);
    const dCam=pl.nx*(camAc.x-a.centroid.x)+pl.ny*(camAc.y-a.centroid.y)+pl.nz*(camAc.z-a.centroid.z);
    const dCc =pl.nx*(a.cc.x-a.centroid.x)+pl.ny*(a.cc.y-a.centroid.y)+pl.nz*(a.cc.z-a.centroid.z);
    const drop=!!faces(a.pts,a.portalSide,camAc,0);
    if(!drop){keptN++;continue;}
    dropped++;
    if(Math.abs(dCc)<2.0){nearPlane++;continue;}      // weak witness, no verdict
    const sameSide=(dCam>0)===(dCc>0);
    if(sameSide) correctDrop++;                        // camera IS in the room
    else{ suspicious++;
      if(offenders.length<10) offenders.push({
        centroid:{x:+a.centroid.x.toFixed(1),y:+a.centroid.y.toFixed(1),z:+a.centroid.z.toFixed(1)},
        dCam:+dCam.toFixed(2), dCc:+dCc.toFixed(2), portalSide:a.portalSide}); }
  }
  return {camAc:{x:+camAc.x.toFixed(1),y:+camAc.y.toFixed(1),z:+camAc.z.toFixed(1)},
          total:r.parsed, gateKept:keptN, gateDropped:dropped,
          correctDrop, suspicious, weakWitness:nearPlane, offenders};
};
(()=>{ return window.__mkMvp()?'ok':'<no-cam-or-worldRoot>'; })()`;

const CENSUS = `
(()=>{
  const pc=window.__pc; if(!pc) return '<no-module>';
  const r=window.__apertures(); if(r.err) return r;
  const faces=pc.apertureFacesAwayWithSide;
  const B={strong:{ok:0,bad:0},weak:{ok:0,bad:0},degenerate:0}; const off=[];
  for(const a of r.aps){
    const pl=window.__plane(a.pts);
    const d=pl.nx*(a.cc.x-a.centroid.x)+pl.ny*(a.cc.y-a.centroid.y)+pl.nz*(a.cc.z-a.centroid.z);
    if(!isFinite(d)){B.degenerate++;continue;}
    const dropAtCentre=!!faces(a.pts,a.portalSide,a.cc,0);
    const o={x:a.cc.x-2*d*pl.nx,y:a.cc.y-2*d*pl.ny,z:a.cc.z-2*d*pl.nz};
    const dropOutside=!!faces(a.pts,a.portalSide,o,0);
    const strong=Math.abs(d)>=2.0, ok=dropAtCentre&&!dropOutside;
    B[strong?'strong':'weak'][ok?'ok':'bad']++;
    if(!ok&&strong&&off.length<12) off.push({centroid:a.centroid,dCentre:+d.toFixed(2),portalSide:a.portalSide});
  }
  return {parsed:r.parsed,buckets:B,offenders:off};
})()`;

// WALL openings only: |n.z| <= 0.35. Camera at the aperture's own centre height.
const PICK = `
(()=>{
  const r=window.__apertures(); if(r.err) return r;
  const cand=[];
  for(const a of r.aps){
    const pl=window.__plane(a.pts);
    if(Math.abs(pl.nz)>0.35) continue;                 // not a wall opening
    const d=pl.nx*(a.cc.x-a.centroid.x)+pl.ny*(a.cc.y-a.centroid.y)+pl.nz*(a.cc.z-a.centroid.z);
    if(!isFinite(d)||Math.abs(d)<1.0) continue;        // need a clear interior
    let x0=1e9,y0=1e9,z0=1e9,x1=-1e9,y1=-1e9,z1=-1e9; const n=a.pts.length/3;
    for(let i=0;i<n;i++){const x=a.pts[i*3],y=a.pts[i*3+1],z=a.pts[i*3+2];
      x0=Math.min(x0,x);y0=Math.min(y0,y);z0=Math.min(z0,z);
      x1=Math.max(x1,x);y1=Math.max(y1,y);z1=Math.max(z1,z);}
    const w=Math.hypot(x1-x0,y1-y0), h=z1-z0;
    if(w<1.2||h<1.2) continue;                          // real doorway/window
    const sgn=d>0?-1:1;                                 // AWAY from the interior
    cand.push({c:a.centroid,n:{x:pl.nx*sgn,y:pl.ny*sgn,z:pl.nz*sgn},w:+w.toFixed(2),h:+h.toFixed(2),ps:a.portalSide});
  }
  cand.sort((p,q)=>(q.w*q.h)-(p.w*p.h));
  const picks=cand.slice(0,4).map((p,i)=>({
    tag:'wall'+(i+1),
    eye:{x:+(p.c.x+p.n.x*${STANDOFF}).toFixed(2),y:+(p.c.y+p.n.y*${STANDOFF}).toFixed(2),z:+(p.c.z+p.n.z*${STANDOFF}).toFixed(2)},
    at:{x:+p.c.x.toFixed(2),y:+p.c.y.toFixed(2),z:+p.c.z.toFixed(2)},
    w:p.w,h:p.h,portalSide:p.ps}));
  window.__picks=picks;
  return {cands:cand.length,picks};
})()`;

const steps = [
  { op: "plateau", minLbs: 10 },
  { op: "eval", name: "loadmod", expr: LOADMOD },
  { op: "chat", text: "@telepoi Holtburg", settleMs: 14000 },
  { op: "plateau", minLbs: 10 },
  { op: "wait", ms: 10000 },
  { op: "eval", name: "worldPose", expr:
    "(()=>{const p=window.liveScene3d?.sessionHandle?.getLocalPlayerPose?.();" +
    "if(!p) return '<no-pose>';const lb=p.landblockId>>>0;" +
    "const wx=((lb>>>24)&0xff)*192+p.x, wy=((lb>>>16)&0xff)*192+p.y, wz=p.z;" +
    "try{p.free?.()}catch(e){}window.__wpos={wx,wy,wz};" +
    "return {lb:'0x'+lb.toString(16),wx:+wx.toFixed(2),wy:+wy.toFixed(2),wz:+wz.toFixed(2)};})()" },
  { op: "eval", name: "mvp", expr: MVP },
  { op: "eval", name: "census", expr: CENSUS },
];

// Forced picks make the two arms shoot IDENTICAL cameras.
let forced = null;
if (PICKS_FILE) {
  forced = JSON.parse(fs.readFileSync(PICKS_FILE, "utf8"));
  steps.push({ op: "eval", name: "forcePicks",
    expr: `(()=>{window.__picks=${JSON.stringify(forced)}; return window.__picks.length;})()` });
} else {
  steps.push({ op: "eval", name: "picks", expr: PICK });
}

// The ORIGINAL orbit rig too — `n-low` is the row the prior report flagged as
// unexplained (8 offered / 0 kept / 8 backface). The audit adjudicates it.
const RIG = [["n-low",34,0,18],["e-low",34,90,18],["s-low",34,180,18],["w-low",34,270,18]];
for (const [tag, dist, az, el] of RIG) {
  steps.push({ op:"eval", name:`cam-${tag}`,
    expr:`window.__cam.orbit(window.__wpos.wx,window.__wpos.wy,window.__wpos.wz,${dist},${az},${el})` });
  steps.push({ op:"wait", ms:4000 });
  steps.push({ op:"eval", name:`audit-${tag}`, expr:"window.__audit()" });
  steps.push({ op:"eval", name:`diag-${tag}`, expr:DIAG });
}

for (let i = 1; i <= 4; i++) {
  steps.push({ op:"eval", name:`cam-wall${i}`,
    expr:`(()=>{const p=(window.__picks||[])[${i-1}]; if(!p) return '<no-pick>';`+
         `window.__cam.set(p.eye.x,p.eye.y,p.eye.z,p.at.x,p.at.y,p.at.z); return p;})()` });
  steps.push({ op:"wait", ms:5000 });
  steps.push({ op:"shot", name:`${ARM}-wall${i}` });
  steps.push({ op:"eval", name:`audit-wall${i}`, expr:"window.__audit()" });
  steps.push({ op:"eval", name:`diag-wall${i}`, expr:DIAG });
}

fs.writeFileSync(`/home/wbterminal/fanout-s12/B/eyetest-B/${ARM}.json`,
  JSON.stringify({ arm:ARM, url, port:PORT_CDP,
    outDir:"/home/wbterminal/fanout-s12/B/eyetest-B/out",
    viewport:[1280,800], hardTimeoutMs:1500000, steps }, null, 1));
console.log(`/home/wbterminal/fanout-s12/B/eyetest-B/${ARM}.json`);
