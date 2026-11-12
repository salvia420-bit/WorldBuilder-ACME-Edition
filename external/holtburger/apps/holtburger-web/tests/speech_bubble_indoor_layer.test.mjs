// tests/speech_bubble_indoor_layer.test.mjs — indoor layer and depthTest for speech bubbles.
//
// Verifies:
// 1. Speech bubble sprites are assigned to RENDER_LAYER_INDOOR (layer 1) so under
//    ?indoorDepthSplit they composite with the interior cells/entities pass (pass 2)
//    rather than being wiped by the full-screen depth clear after layer 0.
// 2. Material has depthTest: true and depthWrite: false so dungeon walls occlude bubbles
//    in adjacent rooms/corridors (preventing wall X-ray).
// 3. Centralized active bubbles registry avoids detached per-bubble rAF loops and allows
//    deterministic simulation-time ticking via tickSpeechBubbles(now).
// 4. Lifecycle cleanup: hold, fade, replacement on new speech, and explicit removal.

import assert from "node:assert/strict";
import * as THREE from "three";
import {
  showSpeechBubbleOnEntity,
  removeSpeechBubbleFromEntity,
  tickSpeechBubbles,
  getActiveSpeechBubbles,
  clearAllSpeechBubbles,
} from "../scene3d/speech_bubble.js";
import { RENDER_LAYER_INDOOR } from "../scene3d/particles/render_layer.js";

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log("  ok ", name);
  } catch (e) {
    failures++;
    console.log("  FAIL", name);
    console.error(e);
  }
}

// Minimal DOM mock if running in bare Node without document
if (typeof document === "undefined") {
  globalThis.document = {
    createElement(tag) {
      if (tag === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext() {
            return {
              font: "",
              measureText(text) {
                return { width: String(text).length * 10 };
              },
              roundRect() {},
              beginPath() {},
              fill() {},
              fillRect() {},
              strokeText() {},
              fillText() {},
            };
          },
        };
      }
      return {};
    },
  };
}

clearAllSpeechBubbles();

test("T1: bubble sprite assigned to RENDER_LAYER_INDOOR (layer 1)", () => {
  const root = new THREE.Group();
  root.layers.set(RENDER_LAYER_INDOOR); // layer 1 (mask = 2)
  const inst = { root };

  const sprite = showSpeechBubbleOnEntity(inst, "Hello Dereth!", false);
  assert.ok(sprite, "sprite should be returned");
  assert.equal(sprite.layers.mask, 1 << RENDER_LAYER_INDOOR, "sprite must be on layer 1");
  assert.equal(sprite.renderOrder, 11, "renderOrder should be 11 (above nameplate 10)");
  assert.equal(inst._speechBubble, sprite, "inst._speechBubble should point to sprite");
  assert.equal(sprite.parent, root, "sprite should be parented to inst.root");
});

test("T2: bubble material has depthTest: true and depthWrite: false", () => {
  const root = new THREE.Group();
  const inst = { root };

  const sprite = showSpeechBubbleOnEntity(inst, "Looking through walls is forbidden", false);
  assert.ok(sprite);
  const mat = sprite.material;
  assert.ok(mat, "material must exist");
  assert.equal(mat.depthTest, true, "depthTest must be true to prevent wall X-ray");
  assert.equal(mat.depthWrite, false, "depthWrite must be false so overlapping bubbles don't z-fight");
  assert.equal(mat.transparent, true, "transparent must be true for alpha fade");
});

test("T3: shared active bubbles set avoids detached per-bubble rAF loops", () => {
  clearAllSpeechBubbles();

  const inst1 = { root: new THREE.Group() };
  const inst2 = { root: new THREE.Group() };

  const s1 = showSpeechBubbleOnEntity(inst1, "Speaker 1", false);
  const s2 = showSpeechBubbleOnEntity(inst2, "Speaker 2", true);

  const active = getActiveSpeechBubbles();
  assert.equal(active.length, 2, "both bubbles should be tracked in the shared active registry");
  assert.ok(active.some((e) => e.sprite === s1));
  assert.ok(active.some((e) => e.sprite === s2));

  // Re-speaking replaces old bubble in active set without leaking
  const s1New = showSpeechBubbleOnEntity(inst1, "Speaker 1 speaks again", false);
  const activeAfterRespeak = getActiveSpeechBubbles();
  assert.equal(activeAfterRespeak.length, 2, "count remains 2 after replacement");
  assert.ok(!activeAfterRespeak.some((e) => e.sprite === s1), "old sprite should be removed from active");
  assert.ok(activeAfterRespeak.some((e) => e.sprite === s1New), "new sprite should be in active");
});

test("T4: deterministic hold and fade via tickSpeechBubbles", () => {
  clearAllSpeechBubbles();

  const root = new THREE.Group();
  const inst = { root };
  const sprite = showSpeechBubbleOnEntity(inst, "Fading words", false);

  const t0 = 10000;
  // Hold period: t0 to t0 + 4500ms -> opacity is 1.0
  const active = getActiveSpeechBubbles();
  assert.equal(active.length, 1);
  active[0].start = t0;

  tickSpeechBubbles(t0 + 2000);
  assert.equal(sprite.material.opacity, 1.0, "should remain fully opaque during hold");

  // Fade period: at t0 + 4500ms + 600ms (halfway through 1200ms fade) -> opacity ~0.5
  tickSpeechBubbles(t0 + 5100);
  assert.ok(Math.abs(sprite.material.opacity - 0.5) < 0.05, `opacity should be ~0.5, got ${sprite.material.opacity}`);

  // Expired: at t0 + 5700ms -> sprite should be disposed and removed
  tickSpeechBubbles(t0 + 5800);
  assert.equal(inst._speechBubble, null, "speechBubble should be cleared from entity");
  assert.equal(getActiveSpeechBubbles().length, 0, "active set should be empty");
  assert.equal(sprite.parent, null, "sprite should be detached from parent");
});

test("T5: removeSpeechBubbleFromEntity cleans up active tracking immediately", () => {
  clearAllSpeechBubbles();

  const root = new THREE.Group();
  const inst = { root };
  const sprite = showSpeechBubbleOnEntity(inst, "Short lived", false);
  assert.equal(getActiveSpeechBubbles().length, 1);

  removeSpeechBubbleFromEntity(inst);
  assert.equal(inst._speechBubble, null);
  assert.equal(getActiveSpeechBubbles().length, 0);
  assert.equal(sprite.parent, null);
});

console.log(`\n${failures ? `${failures} failed` : "All tests passed, 0 failed"}`);
process.exit(failures ? 1 : 0);
