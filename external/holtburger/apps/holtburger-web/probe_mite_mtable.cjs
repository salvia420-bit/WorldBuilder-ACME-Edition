// Tiny probe — load the Mite Sentry mtable (0x0900000B) and dump its
// cycle keys to confirm the WALK_FORWARD slot is genuinely absent.
//
// We don't have a direct mtable-introspection wasm export, so this
// just hits the wasm-bindgen `fetchEntityAnimationKeyframes` with
// many different (stance, command) combinations and reports which
// ones return numFrames > 0.

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const distDir = path.resolve(__dirname, "../../dist");
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.replace(/^\/+/, ""));
  const filePath = path.join(distDir, url);
  if (!filePath.startsWith(distDir)) { res.writeHead(403); res.end(); return; }
  res.setHeader("Connection", "close");
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length });
    res.end(data);
  });
});
server.keepAliveTimeout = 0;

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const wasm = require("./pkg-node/holtburger_web.js");
  await wasm.init_resource_source(`http://127.0.0.1:${port}/manifest.json`);

  const setupId = 0x02001080;  // Mite Sentry setup
  const mtableId = 0x0900000b; // Mite Sentry mtable

  // Common AC stances + commands.
  const STANCES = [
    0,                  // → use mtable.default_style
    0x80000000,         // base substate
    0x8000003d,         // NonCombat
    0x80000010,         // HandCombat
    0x8000003a,         // Magic
    0x80000043,         // Bow
  ];
  const COMMANDS = [
    { name: "Ready",          v: 0x41000003 },
    { name: "Dead",           v: 0x41000004 },
    { name: "WalkForward",    v: 0x45000005 },
    { name: "RunForward",     v: 0x44000007 },
    { name: "WalkBackwards",  v: 0x45000006 },
    { name: "TurnLeft",       v: 0x6500000e },
    { name: "TurnRight",      v: 0x6500000d },
    { name: "AttackHigh1",    v: 0x44000010 },
    { name: "AttackLow1",     v: 0x44000012 },
    { name: "DamageEvent",    v: 0x4100003e },
  ];

  console.log(`probing mite-sentry setup=0x${setupId.toString(16)} mtable=0x${mtableId.toString(16)}`);
  let any = false;
  for (const st of STANCES) {
    for (const c of COMMANDS) {
      try {
        const anim = await wasm.fetchEntityAnimationKeyframes(
          setupId, new Uint32Array(0), new Uint32Array(0), 0, new Uint32Array(0),
          mtableId, c.v, st,
        );
        if (anim.numFrames > 0) {
          console.log(`  HIT stance=0x${st.toString(16).padStart(8,"0")} cmd=${c.name.padEnd(15)} (0x${c.v.toString(16)}) → frames=${anim.numFrames} fps=${anim.framerate.toFixed(1)} resolvedStance=0x${anim.resolvedStance.toString(16)}`);
          any = true;
        }
      } catch (e) { /* ignore */ }
    }
  }
  if (!any) console.log("  (no cycles fired across the standard stance+command grid)");
  server.close();
})();
