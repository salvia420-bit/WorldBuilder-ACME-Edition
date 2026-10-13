// tests/icon_blit_ops.test.mjs — hud-ui-3 (2026-10-13): retail icon blit ops.
//
// `IconData::RenderIcons` (acclient.c:437901) blits each layer with its own
// op: drag = icon SrcCopy + overlay FourChannelAlpha (then white → effect
// tile); icon = background SrcCopy + underlay ThreeChannelAlpha + drag
// ThreeChannelAlpha. The ops are the ARGB→ARGB loops at acclient.c:631018
// (ThreeChannelAlpha) and :642714 (FourChannelAlpha). Before this, every
// layer went through one float alpha-over (`composeLayers`), which darkened
// a half-alpha overlay pixel over a transparent icon pixel twice.
//
// Run from apps/holtburger-web/:  node tests/icon_blit_ops.test.mjs

import assert from "node:assert/strict";
import * as C from "../ui/ac_icon_compose.js";

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};
const solid = (w, h, rgba) => {
  const p = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) p.set(rgba, i * 4);
  return { width: w, height: h, pixels: p };
};
const px = (img, x, y) => Array.from(img.pixels.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const op = (fn, dst, src) => {
  const d = new Uint8ClampedArray(dst);
  fn(d, 0, new Uint8ClampedArray(src), 0);
  return Array.from(d);
};
// ThreeChannelAlpha's MMX lerp, per channel (w = sa + 1).
const lerp3 = (d, s, sa) => d - ((d * (sa + 1)) >> 8) + ((s * (sa + 1)) >> 8);

check("FourChannelAlpha onto a transparent dst pixel copies the src byte-exact", () => {
  assert.deepEqual(op(C.fourChannelAlpha, [10, 20, 30, 0], [200, 100, 50, 128]), [200, 100, 50, 128]);
  // The old single alpha-over darkened it (rgb scaled by sa).
  const old = C.composeLayers([solid(1, 1, [10, 20, 30, 0]), solid(1, 1, [200, 100, 50, 128])]);
  assert.ok(px(old, 0, 0)[0] < 120, `old composite was ${px(old, 0, 0)}`);
});

check("FourChannelAlpha: src alpha 255 is copied whatever the dst", () => {
  assert.deepEqual(op(C.fourChannelAlpha, [10, 20, 30, 77], [1, 2, 3, 255]), [1, 2, 3, 255]);
  assert.deepEqual(op(C.fourChannelAlpha, [10, 20, 30, 255], [1, 2, 3, 255]), [1, 2, 3, 255]);
});

check("FourChannelAlpha: src alpha 0 leaves the dst untouched", () => {
  assert.deepEqual(op(C.fourChannelAlpha, [10, 20, 30, 40], [200, 100, 50, 0]), [10, 20, 30, 40]);
});

check("FourChannelAlpha: an opaque dst lerps rgb (ThreeChannelAlpha) and stays 255", () => {
  assert.deepEqual(op(C.fourChannelAlpha, [100, 100, 100, 255], [200, 0, 50, 128]),
    [lerp3(100, 200, 128), lerp3(100, 0, 128), lerp3(100, 50, 128), 255]);
  assert.deepEqual(op(C.fourChannelAlpha, [100, 100, 100, 255], [200, 0, 50, 128]), [150, 50, 75, 255]);
});

check("FourChannelAlpha: partial dst = non-premultiplied over, A = w - ((w*(da+1))>>8) + da + 1", () => {
  // w = 129, da+1 = 129 → A = 129 - 65 + 129 = 193; c = d - (d - s)*129/193.
  assert.deepEqual(op(C.fourChannelAlpha, [100, 100, 100, 128], [200, 0, 50, 128]), [167, 33, 67, 192]);
});

check("FourChannelAlpha rounds half to even (cvtps2pi), not half up", () => {
  // sa = da = 1 → w = 2, A = 4: 0 + 13*2/4 = 6.5 → 6; 7 - 3.5 = 3.5 → 4; 14 - 0.5 = 13.5 → 14.
  assert.deepEqual(op(C.fourChannelAlpha, [0, 7, 14, 1], [13, 0, 13, 1]), [6, 4, 14, 3]);
});

check("ThreeChannelAlpha keeps the dst alpha (lerp, copy at 255, skip at 0)", () => {
  assert.deepEqual(op(C.threeChannelAlpha, [100, 100, 100, 77], [200, 0, 50, 128]), [150, 50, 75, 77]);
  assert.deepEqual(op(C.threeChannelAlpha, [100, 100, 100, 77], [1, 2, 3, 255]), [1, 2, 3, 77]);
  assert.deepEqual(op(C.threeChannelAlpha, [100, 100, 100, 0], [1, 2, 3, 255]), [1, 2, 3, 0]);
  assert.deepEqual(op(C.threeChannelAlpha, [100, 100, 100, 77], [1, 2, 3, 0]), [100, 100, 100, 77]);
});

check("SrcCopy copies all four channels", () => {
  assert.deepEqual(op(C.srcCopy, [9, 9, 9, 9], [1, 2, 3, 4]), [1, 2, 3, 4]);
});

check("composite: a half-alpha overlay over a transparent icon pixel is NOT darkened", () => {
  const bg = solid(1, 1, [10, 20, 30, 255]);
  const icon = solid(1, 1, [0, 0, 0, 0]);
  const overlay = solid(1, 1, [200, 100, 50, 128]);
  const tile = solid(1, 1, [0, 0, 0, 255]);
  const { icon: out, drag } = C.composeItemIcon({ background: bg, icon, overlay, effectTile: tile });
  assert.deepEqual(px(drag, 0, 0), [200, 100, 50, 128]);
  const want = [lerp3(10, 200, 128), lerp3(20, 100, 128), lerp3(30, 50, 128), 255];
  assert.deepEqual(px(out, 0, 0), want);
  assert.deepEqual(want, [105, 60, 40, 255]);
  // The pre-hud-ui-3 path (?iconBlitRetail=off) gives the dark fringe.
  const { icon: old } = C.composeItemIcon({ background: bg, icon, overlay, effectTile: tile }, { retailBlit: false });
  assert.ok(px(old, 0, 0)[0] < 70, `old composite was ${px(old, 0, 0)}`);
});

check("composite: underlay and drag blit with ThreeChannelAlpha (background alpha kept)", () => {
  const bg = solid(1, 1, [40, 40, 40, 255]);
  const underlay = solid(1, 1, [240, 0, 0, 64]);
  const icon = solid(1, 1, [0, 0, 240, 200]);
  const { icon: out } = C.composeItemIcon({ background: bg, underlay, icon, effectTile: null });
  let r = lerp3(40, 240, 64), g = lerp3(40, 0, 64), b = lerp3(40, 0, 64);
  r = lerp3(r, 0, 200); g = lerp3(g, 0, 200); b = lerp3(b, 240, 200);
  assert.deepEqual(px(out, 0, 0), [r, g, b, 255]);
});

check("composite without the background: the icon still shows where the underlay is transparent (review R6)", () => {
  // A failed background fetch must not make the underlay the base: a
  // ThreeChannelAlpha drag onto it would keep the underlay's alpha 0.
  const underlay = solid(2, 1, [0, 0, 0, 0]);
  underlay.pixels.set([240, 0, 0, 255], 0); // opaque only at x=0
  const icon = solid(2, 1, [0, 0, 240, 255]);
  icon.pixels.set([0, 200, 0, 128], 0);
  const { icon: out } = C.composeItemIcon({ background: null, underlay, icon, effectTile: null });
  assert.deepEqual(px(out, 1, 0), [0, 0, 240, 255], "icon pixel over a transparent underlay pixel is visible");
  assert.deepEqual(px(out, 0, 0), [lerp3(240, 0, 128), lerp3(0, 200, 128), lerp3(0, 0, 128), 255], "over an opaque underlay pixel = the lerp");
  const lone = C.composeItemIcon({ background: null, icon, effectTile: null });
  assert.deepEqual(Array.from(lone.icon.pixels), Array.from(lone.drag.pixels), "no background, no underlay → the drag icon as is");
  assert.equal(C.composeItemIcon({ background: null, underlay: null, icon: null, effectTile: null }).icon, null);
});

check("blitLayers: the first present layer is the base; later layers clip to it", () => {
  const a = solid(2, 1, [1, 2, 3, 255]);
  const b = solid(1, 1, [9, 9, 9, 255]);
  const out = C.blitLayers([[null, C.srcCopy], [a, C.srcCopy], [b, C.threeChannelAlpha]]);
  assert.equal(out.width, 2);
  assert.deepEqual(px(out, 0, 0), [9, 9, 9, 255]);
  assert.deepEqual(px(out, 1, 0), [1, 2, 3, 255]);
  assert.equal(C.blitLayers([[null, C.srcCopy]]), null);
});

check("?iconBlitRetail escape: default ON; off / 0 / false restore the old composite", () => {
  assert.equal(C.iconBlitRetailEnabled(""), true);
  assert.equal(C.iconBlitRetailEnabled(undefined), true);
  assert.equal(C.iconBlitRetailEnabled("?iconBlitRetail=on"), true);
  assert.equal(C.iconBlitRetailEnabled("?iconBlitRetail=off"), false);
  assert.equal(C.iconBlitRetailEnabled("?x=1&iconBlitRetail=0"), false);
  assert.equal(C.iconBlitRetailEnabled("?iconBlitRetail=false"), false);
});

check("retail path matches the old one wherever the old one was already right", () => {
  // Opaque pixels, transparent pixels and the white-key replace are unchanged.
  const bg = solid(2, 1, [10, 20, 30, 255]);
  const icon = solid(2, 1, [0, 0, 0, 0]);
  icon.pixels.set([255, 255, 255, 255], 0);
  const tile = solid(2, 1, [7, 8, 9, 255]);
  const a = C.composeItemIcon({ background: bg, icon, effectTile: tile });
  const b = C.composeItemIcon({ background: bg, icon, effectTile: tile }, { retailBlit: false });
  assert.deepEqual(Array.from(a.icon.pixels), Array.from(b.icon.pixels));
  assert.deepEqual(Array.from(a.drag.pixels), Array.from(b.drag.pixels));
});

console.log(`\nicon_blit_ops: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
