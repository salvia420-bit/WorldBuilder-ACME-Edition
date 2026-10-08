// tests/pick_math.test.mjs — selection-5 (2026-10-08): retail's mouse pick
// falls back to the nearest drawing-sphere hit when no polygon was hit
// (Render::GfxObjUnderSelectionRay acclient.c:379997-380073,
// Render::GetMouseSelectionObjectID :380089, CSphere::sphere_intersects_ray).
// Ports OpenAC RetailWorldPickerTests (SphereIsUsedOnlyWhenNoVisiblePolygonHits,
// DrawingSphereRejectsRayWhichBeginsInsideLikeRetail) to plain spheres, plus
// the picking.js wiring (source assertions — picking.js needs DOM + three).
//
// Run from apps/holtburger-web/:  node tests/pick_math.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sphereRayEntry, pickNearestSphereHit } from "../scene3d/pick_math.js";

const O = { x: 0, y: 0, z: 0 };
const FWD = { x: 0, y: 0, z: -1 };
const sp = (guid, cz, r = 1, cx = 0, cy = 0) => ({ guid, cx, cy, cz, r });

test("entry distance along the ray (in units of |dir|)", () => {
  assert.equal(sphereRayEntry(0, 0, 0, 0, 0, -1, 0, 0, -10, 1), 9);
  assert.equal(sphereRayEntry(0, 0, 0, 0, 0, -2, 0, 0, -10, 1), 4.5);
  // Grazing: a sphere 0.9 off the ray axis with radius 1 is still entered.
  assert.ok(sphereRayEntry(0, 0, 0, 0, 0, -1, 0.9, 0, -10, 1) > 0);
});

test("the nearest sphere the ray enters wins", () => {
  assert.equal(pickNearestSphereHit(O, FWD, [sp(0xB, -20), sp(0xA, -5), sp(0xC, -50)]), 0xA);
});

test("a ray that begins inside a sphere does not hit it (retail c <= 0)", () => {
  assert.equal(sphereRayEntry(0, 0, 0, 0, 0, -1, 0, 0, -0.5, 1), -1);
  // The camera inside a big sphere: the next sphere along the ray is picked.
  assert.equal(pickNearestSphereHit(O, FWD, [sp(0xA, 0, 5), sp(0xB, -10)]), 0xB);
});

test("misses, spheres behind the eye and a degenerate ray pick nothing", () => {
  assert.equal(pickNearestSphereHit(O, FWD, [sp(0xA, -10, 1, 5)]), null, "off to the side");
  assert.equal(pickNearestSphereHit(O, FWD, [sp(0xA, 10)]), null, "behind the eye");
  assert.equal(pickNearestSphereHit(O, { x: 0, y: 0, z: 0 }, [sp(0xA, -10)]), null, "zero direction");
  assert.equal(pickNearestSphereHit(O, FWD, []), null);
});

test("equal entry distance keeps the first sphere; `count` bounds a pooled array", () => {
  assert.equal(pickNearestSphereHit(O, FWD, [sp(0xA, -10), sp(0xB, -10)]), 0xA);
  assert.equal(pickNearestSphereHit(O, FWD, [sp(0xA, -20), sp(0xB, -5)], 1), 0xA);
});

test("picking.js: the sphere pass runs only after the polygon hits found nothing", () => {
  const src = readFileSync(new URL("../scene3d/picking.js", import.meta.url), "utf8");
  assert.match(src, /import \{ pickNearestSphereHit \} from "\.\/pick_math\.js";/);
  assert.match(src, /get\("pickSphereFallback"\)/);
  const pick = src.slice(src.indexOf("  function pickEntityAt(clientX, clientY) {"));
  const body = pick.slice(0, pick.indexOf("\n  }\n"));
  const loop = body.indexOf("for (const hit of hits)");
  const fb = body.indexOf("pickBySphere(em, guidByRoot, localGuid)");
  assert.ok(loop > 0 && fb > loop, "fallback after the polygon loop");
  assert.match(body, /return PICK_SPHERE_FALLBACK \? pickBySphere\(em, guidByRoot, localGuid\) : null;/);
  // Rig-part meshes only, drawn, never the local player's own held items.
  const sphere = src.slice(src.indexOf("  function pickBySphere("));
  assert.match(sphere, /const parts = inst\?\.parts;/);
  assert.match(sphere, /if \(!m\.isMesh \|\| m\.visible === false \|\| !m\.geometry\) continue;/);
  assert.match(sphere, /\(inst\._attachedParentGuid >>> 0\) === localGuid\) continue;/);
});
