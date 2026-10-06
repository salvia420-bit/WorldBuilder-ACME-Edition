// 2026-10-06 — the far-fog probe's async readback must not leave three's
// PIXEL_PACK_BUFFER bound. three r184 `readRenderTargetPixelsAsync` binds it,
// issues readPixels and awaits the fence with it STILL bound, so every
// synchronous readPixels into an array for the rest of the frame failed with
// INVALID_OPERATION and returned zeros (1070: every 12th frame read black).
//
// Run:
//   cd apps/holtburger-web/
//   node test_fog_probe_pbo_unbind.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

const src = readFileSync(resolve(here, "scene3d/loop.js"), "utf8");
const call = src.indexOf("renderer.readRenderTargetPixelsAsync(");
check("the fog probe uses three's async readback", call > 0);
const ret = src.indexOf("return null; // the caller keeps `_fogProbeLast`", call);
const body = src.slice(call, ret);
check("…and unbinds PIXEL_PACK_BUFFER before returning to the frame",
  /bindBuffer\(\s*gl\.PIXEL_PACK_BUFFER\s*,\s*null\s*\)/.test(body), body.length + " chars between call and return");

// Model of the r184 call: the bind + readPixels happen synchronously before
// the first await, so the binding is live when the call returns.
{
  const gl = { PIXEL_PACK_BUFFER: 0x88eb, bound: null, bindBuffer(t, b) { if (t === this.PIXEL_PACK_BUFFER) this.bound = b; } };
  async function readAsync() { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, { buf: 1 }); await null; gl.bindBuffer(gl.PIXEL_PACK_BUFFER, { buf: 1 }); }
  const p = readAsync();
  check("model: the async readback returns with the pack buffer still bound", gl.bound !== null);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  check("model: the unbind clears it for the rest of the frame", gl.bound === null);
  await p;
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
