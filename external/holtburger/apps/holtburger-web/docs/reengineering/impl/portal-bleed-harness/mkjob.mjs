#!/usr/bin/env node
// mkjob.mjs — emit one lane-B punch arm job. Same camera rig for every arm, so
// the only difference between two arms is the flag in the URL.
//
// usage: node mkjob.mjs <arm> <sidednessMode|"default"> [extraQuery]
//
// The camera rig is expressed against `window.__wpos`, which step 4 derives at
// RUNTIME from the live player pose (AC world metres = lbIndex*192 + local).
// Nothing here hardcodes a world anchor — the queue's Holtburg anchor is ~10 km
// off where `@telepoi Holtburg` actually lands, so a literal would be worthless.

import fs from "node:fs";

const [, , ARM, MODE, EXTRA = ""] = process.argv;
if (!ARM || !MODE) {
  console.error("usage: node mkjob.mjs <arm> <default|on|heuristic> [extraQuery]");
  process.exit(1);
}

const PORT_SERVE = 8772;   // lane B serve port
const PORT_CDP = 9342;     // lane B chrome debug port
const ACCOUNT = "agentp09";

const q = [
  "nosw=1",              // service worker caches index.html — mandatory
  "autoLogin=1",
  "autoSpawn=first",
  "agent=1",
  "skytime=12",          // fixed time of day: same light in every arm
  "camDebug=on",         // window.__cam freecam rig
  "renderScale=1",       // else adaptiveRes pins us to 448x280
  `account=${ACCOUNT}`,
  `password=${ACCOUNT}`,
  // The box reaches ACE DIRECTLY over Tailscale — there is no reverse tunnel,
  // so the built-in `ws://127.0.0.1:8080/` default cannot connect. The bridge
  // runs on the owner's laptop and proxies to ACE on ITS OWN loopback, so
  // server_host/server_port stay at their 127.0.0.1:9000 defaults.
  `bridge_url=${encodeURIComponent("ws://100.116.47.66:8080/")}`,
];
if (MODE !== "default") q.push(`punchSidedness=${MODE}`);
if (EXTRA) q.push(EXTRA);

const url = `http://127.0.0.1:${PORT_SERVE}/apps/holtburger-web/index.html?${q.join("&")}`;

// ── the shared camera rig ────────────────────────────────────────────────────
// (dist, az, el) triples in AC world metres / degrees, orbiting the runtime
// player position. Low elevations look at facades (the "through a wall" case);
// high elevations look down on rooftops (the "through a roof" case).
const RIG = [
  ["n-low", 34, 0, 18],
  ["e-low", 34, 90, 18],
  ["s-low", 34, 180, 18],
  ["w-low", 34, 270, 18],
  ["se-mid", 42, 135, 34],
  ["over-45", 52, 180, 52],
  ["over-hi", 68, 45, 62],
];

const DIAG =
  "(()=>{const d=window.liveScene3d?._portalPunchDiag; return d?JSON.parse(JSON.stringify(d)):'<absent>';})()";

const steps = [
  { op: "plateau", minLbs: 10 },
  { op: "eval", name: "portalPunchBanner", expr: "window.__portalPunch||'<absent>'" },
  { op: "chat", text: "@telepoi Holtburg", settleMs: 14000 },
  { op: "plateau", minLbs: 10 },
  { op: "wait", ms: 10000 },
  // RUNTIME anchor derivation. AC world metres from the landblock index:
  // world = ((lbid>>>24)&0xff)*192 + localX,  ((lbid>>>16)&0xff)*192 + localY.
  {
    op: "eval",
    name: "worldPose",
    expr:
      "(()=>{const p=window.liveScene3d?.sessionHandle?.getLocalPlayerPose?.();" +
      "if(!p) return '<no-pose>';" +
      "const lb=p.landblockId>>>0;" +
      "const wx=((lb>>>24)&0xff)*192+p.x, wy=((lb>>>16)&0xff)*192+p.y, wz=p.z;" +
      "try{p.free?.()}catch(e){}" +
      "window.__wpos={wx,wy,wz};" +
      "return {lb:'0x'+lb.toString(16),wx:+wx.toFixed(2),wy:+wy.toFixed(2),wz:+wz.toFixed(2)};})()",
  },
  { op: "eval", name: "indoor", expr: "!!window.liveScene3d?.sessionHandle?.isCurrentCellIndoor?.()" },
  { op: "shot", name: `${ARM}-follow` },
  { op: "eval", name: "diag-follow", expr: DIAG },
];

for (const [tag, dist, az, el] of RIG) {
  steps.push({
    op: "eval",
    name: `cam-${tag}`,
    expr: `window.__cam.orbit(window.__wpos.wx,window.__wpos.wy,window.__wpos.wz,${dist},${az},${el})`,
  });
  steps.push({ op: "wait", ms: 6000 });
  steps.push({ op: "shot", name: `${ARM}-${tag}` });
  steps.push({ op: "eval", name: `diag-${tag}`, expr: DIAG });
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
console.log(url);
